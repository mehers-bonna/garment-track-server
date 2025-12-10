require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require('firebase-admin')
const stripe = require('stripe')(process.env.STRIPE_SECRET)

const port = process.env.PORT || 3000
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf-8'
)
const serviceAccount = JSON.parse(decoded)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const app = express()


// middleware
app.use(express.json())
// app.use(cors());

app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
)


// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.uftqhoa.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});


async function run() {
  try {


    const db = client.db('productsDB')
    const productsCollection = db.collection('products')
    const ordersCollection = db.collection('orders')
    const usersCollection = db.collection('users')


    // save a product data in db
    app.post('/products', async (req, res) => {
      const productData = req.body
      productData.showOnHome = false;
      const result = await productsCollection.insertOne(productData)
      res.send(result)
    })


    // get all products from db
    app.get('/products', async (req, res) => {
      const result = await productsCollection.find().toArray()
      res.send(result)
    })


    // new api Get all FEATURED products for the Home Page (MUST BE FIRST)
    app.get('/products/featured', async (req, res) => {
      const query = {
        $or: [
          { showOnHome: true },
          { showOnHome: "true" }
        ]
      };
      const result = await productsCollection.find(query).toArray();
      res.send(result);
    });


    // get product details
    app.get('/products/:id', async (req, res) => {
      const id = req.params.id
      const result = await productsCollection.findOne({ _id: new ObjectId(id) })
      res.send(result)
    })


    // payment related apis
    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body
      console.log(paymentInfo)
      // res.send(paymentInfo)
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: paymentInfo?.name,
                description: paymentInfo?.description,
                images: [paymentInfo?.image],
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: paymentInfo?.availableQuantity,
          },
        ],
        mode: 'payment',
        metadata: {
          productId: paymentInfo?.productId,
          buyer: paymentInfo?.buyer.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/product/${paymentInfo?.productId}`,
      })

      res.send({ url: session.url })

    })


    app.post('/payment-success', async (req, res) => {
      const { sessionId } = req.body
      const session = await stripe.checkout.sessions.retrieve(sessionId)

      const product = await productsCollection.findOne({ _id: new ObjectId(session.metadata.productId) })

      const order = await ordersCollection.findOne({ transactionId: session.payment_intent })


      if (session.status === 'complete' && product && !order) {
        // save order data in db
        const orderInfo = {
          productId: session.metadata.productId,
          transactionId: session.payment_intent,
          buyer: session.metadata.buyer,
          status: 'Pending',
          manager: product.manager,
          name: product.name,
          category: product.category,
          availableQuantity: product.availableQuantity,
          price: session.amount_total / 100,
        }
        const result = await ordersCollection.insertOne(orderInfo)
        // update product available quantity
        await productsCollection.updateOne(
          {
            _id: new ObjectId(session.metadata.productId),
          },
          { $inc: { availableQuantity: -1 } }
        )

        return res.send({
          transactionId: session.payment_intent,
          orderId: result.insertedId,

        })
      }
      res.send(
        res.send({
          transactionId: session.payment_intent,
          orderId: order._id,

        })
      )
    })


    //api to get all orders with optional status filter for admin dashboard
app.get('/all-orders', async (req, res) => {
    const { status } = req.query; 

    let query = {};
    if (status) {
        query.status = status; 
    }

    const options = {
        sort: { transactionId: -1 } 
    };

    const result = await ordersCollection.find(query, options).toArray();
    res.send(result);
});


    // get all orders for a buyer by email
    app.get('/my-orders/:email', async (req, res) => {
      const email = req.params.email
      const result = await ordersCollection.find({ buyer: email }).toArray()
      res.send(result)
    })

// new api for track order
app.get('/order/:orderId', async (req, res) => {
    const id = req.params.orderId
    
    if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid Order ID format" });
    }

    try {
        const query = { _id: new ObjectId(id) } 
        const orderData = await ordersCollection.findOne(query);

        if (!orderData) {
            return res.status(404).send({ message: "Order not found" });
        }
        
        res.send(orderData); 
        
    } catch (error) {
        console.error("Error fetching order:", error);
        res.status(500).send({ message: "Internal Server Error" });
    }
})

    // get api for approve orders
    app.get('/approve-orders/:email', async (req, res) => {
      const email = req.params.email
      const query = {
        'manager.email': email,
        status: 'Pending'
      }

      const result = await ordersCollection.find(query).toArray()
      res.send(result)
    })

    // get all plants for a manager by email
    app.get('/manage-product/:email', async (req, res) => {
      const email = req.params.email
      const result = await productsCollection.find({ 'manager.email': email }).toArray()
      res.send(result)
    })

    // api for Update a product by id
    app.put('/product/:id', async (req, res) => {
      const id = req.params.id
      const updatedProductData = req.body

      const query = { _id: new ObjectId(id) }

      const updateDoc = {
        $set: {
          ...updatedProductData,
        },
      }
      const result = await productsCollection.updateOne(query, updateDoc)
      res.send(result)
    })

    // new api delete a product by id
    app.delete('/product/:id', async (req, res) => {
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const result = await productsCollection.deleteOne(query)

      res.send(result)
    })

    // api for Update Order Status by id
    app.put('/order-status/:id', async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;

      let updateFields = { status };

      if (status === 'Approved') {
        updateFields.approvedAt = new Date();
      }
      else if (status === 'Rejected') {
        updateFields.approvedAt = null;
      }
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: updateFields,
      };
      const result = await ordersCollection.updateOne(query, updateDoc);

      res.send(result);
    });

    //  api to get all approved orders for a manager by email
    app.get('/approved-orders/:email', async (req, res) => {
      const email = req.params.email
      const query = {
        'manager.email': email,
        status: 'Approved'
      }
      const options = {
        sort: { approvedAt: -1 }
      };
      const result = await ordersCollection.find(query, options).toArray()
      res.send(result)
    })

    // api to add tracking Information to an order 
    app.put('/order-tracking/:id', async (req, res) => {
      const id = req.params.id;
      const trackingData = req.body;

      const newTrackingEntry = {
        ...trackingData,
        timestamp: new Date(),
      };
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $push: { tracking: newTrackingEntry },
        $set: {
          currentTrackingStatus: trackingData.status,
          updatedAt: new Date()
        }
      };
      const result = await ordersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // api to get all users
    app.get('/users', async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // api to Update User Role and Status by id
    app.put('/user/:id', async (req, res) => {
      const id = req.params.id;
      const updatedUserData = req.body; 

      // ⚠️ Optional: Admin check middleware ekhane use kora uchit

      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          role: updatedUserData.role,
          status: updatedUserData.status,
          suspendReason: updatedUserData.suspendReason,
          suspendFeedback: updatedUserData.suspendFeedback,
          updated_at: new Date().toISOString(),
        },
      };
      const result = await usersCollection.updateOne(query, updateDoc);

      res.send(result);
    });

    // save or update a user in db
    app.post('/user', async (req, res) => {
      const userData = req.body
      userData.created_at = new Date().toISOString()
      userData.last_loggedIn = new Date().toISOString()
      userData.role = 'buyer'
      userData.status = 'pending'

      const query = {
        email: userData.email,
      }
      const alreadyExists = await usersCollection.findOne(query)
      console.log('User Already Exists----->', !!alreadyExists)
      if (alreadyExists) {
        console.log('Updating user info......')
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          }
        })
        res.send(result)
        return
      }

      console.log('Saving new user info......')
      const result = await usersCollection.insertOne(userData)
      res.send(result)
    })

    // get a user's role
    app.get('/user/role/:email', async (req, res) => {
      const email = req.params.email
      const result = await usersCollection.findOne({ email })
      res.send({ role: result?.role })
    })

    // api for toggle Product Visibility on Home Page
    app.put('/products/toggle-home/:id', async (req, res) => {
      // ⚠️ Ekhane Admin verification middleware add kora uchit

      const id = req.params.id;
      const { showOnHome } = req.body; 
      if (typeof showOnHome !== 'boolean') {
        return res.status(400).send({ message: 'Invalid value for showOnHome (must be boolean)' });
      }
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: {
          showOnHome: showOnHome, 
          updatedAt: new Date(),
        },
      };

      const result = await productsCollection.updateOne(query, updateDoc);

      res.send(result);
    });


















    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);








app.get('/', (req, res) => {
  res.send('Garment Track server is running')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
